pipeline {
    agent any

    stages {

        stage('Checkout') {
            steps {
                echo 'Checking out GitHub repository'

                git branch: 'main',
                    url: 'https://github.com/Sachin-dev-hub/voting.git'
            }
        }

        stage('Check SonarScanner') {
            steps {
                script {
                    def scannerHome = tool 'SonarScanner'

                    echo "SonarScanner location: ${scannerHome}"

                    sh "${scannerHome}/bin/sonar-scanner --version"
                }
            }
        }

        stage('SonarQube Analysis') {
            steps {
                script {
                    def scannerHome = tool 'SonarScanner'

                    withSonarQubeEnv('SonarQube') {
                        sh """
                            ${scannerHome}/bin/sonar-scanner \
                            -Dsonar.projectKey=my-first-project \
                            -Dsonar.projectName=my-first-project \
                            -Dsonar.sources=.
                        """
                    }
                }
            }
        }
    }
}
